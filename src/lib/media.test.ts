import { describe, expect, it } from 'vitest';
import {
  fileExtension,
  keyToken,
  mediaFailureNotice,
  mimeForPath,
  videoTrackIsUnsupported,
  MEDIA_SCAN_LIMIT,
  selectStaleMedia,
  type MediaRow,
} from './media';
import { AUDIO_KEEP_LIMIT, MEDIA_KEEP_LIMIT } from './conversation';
import type { MediaType } from './types';

function file(name: string, type: string): File {
  return new File(['x'], name, { type });
}

describe('fileExtension', () => {
  it('prefers the extension from the filename, lowercased', () => {
    expect(fileExtension(file('Holiday.JPEG', 'image/jpeg'))).toBe('jpeg');
  });

  it('falls back to the MIME type when the name has no extension', () => {
    expect(fileExtension(file('clipboard', 'image/png'))).toBe('png');
  });

  // The extension is pasted into a Storage object key, and Storage rejects a
  // key holding a character outside its own set — so a second copy of a
  // download, or a recorder that names its codec, must not be able to make a
  // file unsendable.
  it('takes only the leading word, so an odd name still uploads', () => {
    expect(fileExtension(file('shot.jpg (1)', 'image/jpeg'))).toBe('jpg');
    expect(fileExtension(file('note', 'audio/webm;codecs=opus'))).toBe('webm');
    expect(fileExtension(file('drawing', 'image/svg+xml'))).toBe('svg');
  });

  it('falls back to bin when nothing usable is left', () => {
    expect(fileExtension(file('archive.', ''))).toBe('bin');
  });

  // The subtype is not the extension. Scraping it wrote `.quicktime` and
  // `.mpeg`, which nothing mapped back to a type — a video that would never
  // play again, decided at upload and unfixable after it.
  it('writes the canonical extension rather than the MIME subtype', () => {
    expect(fileExtension(file('clip', 'video/quicktime'))).toBe('mov');
    expect(fileExtension(file('track', 'audio/mpeg'))).toBe('mp3');
    expect(fileExtension(file('voice', 'audio/mp4'))).toBe('m4a');
  });

  it('replaces a name extension this app could not read back', () => {
    expect(fileExtension(file('clip.mpg', 'video/mp4'))).toBe('mp4');
    expect(fileExtension(file('voice.opus', 'audio/ogg'))).toBe('ogg');
  });

  it('keeps a legacy name that still reads, rather than churning it', () => {
    // `.quicktim` is what the old scraping produced — the subtype truncated to
    // eight characters — and it is readable now, so there is nothing to fix.
    expect(fileExtension(file('clip.quicktim', 'video/quicktime'))).toBe('quicktim');
  });
});

describe('the object name round-trips', () => {
  // The single rule holding `fileExtension` and `mimeForPath` together: a
  // sealed object announces nothing, so what the sender wrote into the name is
  // the only thing the reader has. Every type the picker accepts has to survive
  // the trip.
  const cases: [string, MediaType][] = [
    ['image/png', 'image'],
    ['image/jpeg', 'image'],
    ['image/webp', 'image'],
    ['image/gif', 'image'],
    ['video/mp4', 'video'],
    ['video/webm', 'video'],
    ['video/quicktime', 'video'],
    ['audio/webm', 'audio'],
    ['audio/ogg', 'audio'],
    ['audio/mp4', 'audio'],
    ['audio/aac', 'audio'],
    ['audio/mpeg', 'audio'],
  ];

  it.each(cases)('%s survives being written into an object name', (type, kind) => {
    const named = `pair/uuid.${fileExtension(file('capture', type))}`;
    expect(mimeForPath(named, kind)).toBe(type);
  });

  it('reads the extensions the old scraping wrote', () => {
    expect(mimeForPath('pair/uuid.quicktim', 'video')).toBe('video/quicktime');
    expect(mimeForPath('pair/uuid.mpeg', 'audio')).toBe('audio/mpeg');
  });
});

function rows(kind: MediaType, count: number, from = 0): MediaRow[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `${kind}-${from + i}`,
    user_id: 'me',
    media_path: `convo/${kind}-${from + i}`,
    media_type: kind,
  }));
}

describe('selectStaleMedia', () => {
  it('keeps everything while both kinds are under their limits', () => {
    expect(selectStaleMedia([...rows('image', MEDIA_KEEP_LIMIT), ...rows('audio', 5)])).toEqual([]);
  });

  it('trims photos past the visual limit, oldest first', () => {
    const stale = selectStaleMedia(rows('image', MEDIA_KEEP_LIMIT + 3));
    expect(stale.map((r) => r.id)).toEqual([
      `image-${MEDIA_KEEP_LIMIT}`,
      `image-${MEDIA_KEEP_LIMIT + 1}`,
      `image-${MEDIA_KEEP_LIMIT + 2}`,
    ]);
  });

  it('counts photos and videos against the same budget', () => {
    const mixed = [...rows('image', MEDIA_KEEP_LIMIT), ...rows('video', 2)];
    expect(selectStaleMedia(mixed).map((r) => r.media_type)).toEqual(['video', 'video']);
  });

  it('gives voice notes their own budget, so a run of them evicts no photos', () => {
    const noisy = [...rows('audio', AUDIO_KEEP_LIMIT), ...rows('image', MEDIA_KEEP_LIMIT)];
    expect(selectStaleMedia(noisy)).toEqual([]);
  });

  it('trims voice notes only past the audio limit', () => {
    const stale = selectStaleMedia(rows('audio', AUDIO_KEEP_LIMIT + 2));
    expect(stale.map((r) => r.id)).toEqual([
      `audio-${AUDIO_KEEP_LIMIT}`,
      `audio-${AUDIO_KEEP_LIMIT + 1}`,
    ]);
  });

  it('ignores rows whose media has already been cleared', () => {
    const cleared: MediaRow[] = Array.from({ length: MEDIA_KEEP_LIMIT + 5 }, (_, i) => ({
      id: `cleared-${i}`,
      user_id: 'me',
      media_path: null,
      media_type: null,
    }));
    expect(selectStaleMedia([...cleared, ...rows('image', MEDIA_KEEP_LIMIT)])).toEqual([]);
  });

  it('never selects a pinned item for pruning', () => {
    const all = rows('image', MEDIA_KEEP_LIMIT + 5);
    const stale = selectStaleMedia(all, new Set(['image-0', 'image-1']));
    expect(stale.map((r) => r.id)).not.toContain('image-0');
    expect(stale.map((r) => r.id)).not.toContain('image-1');
  });

  it('prunes unpinned items past the limit as before', () => {
    expect(selectStaleMedia(rows('image', MEDIA_KEEP_LIMIT + 5), new Set()).length).toBe(5);
  });

  it('does not let a pin count against the budget it protects', () => {
    // Counting a pinned row would push an unpinned one off the end early —
    // pinning your own photo would delete someone else's, which is exactly
    // the trade "pinning is free" is supposed to rule out. Two pins here buy
    // two more surviving rows, not two evictions.
    const all = rows('image', MEDIA_KEEP_LIMIT + 2);
    expect(selectStaleMedia(all, new Set(['image-0', 'image-1']))).toEqual([]);

    const one = rows('image', MEDIA_KEEP_LIMIT + 3);
    const stale = selectStaleMedia(one, new Set(['image-0', 'image-1']));
    expect(stale.map((r) => r.id)).toEqual([`image-${MEDIA_KEEP_LIMIT + 2}`]);
  });

  it('treats an omitted pin set as nothing pinned', () => {
    expect(selectStaleMedia(rows('image', MEDIA_KEEP_LIMIT + 1)).length).toBe(1);
  });

  it('scans far enough that a full pair of budgets can still be trimmed', () => {
    expect(MEDIA_SCAN_LIMIT).toBeGreaterThan(MEDIA_KEEP_LIMIT + AUDIO_KEEP_LIMIT);
  });
});

describe('mimeForPath', () => {
  // Storage serves every sealed object as application/octet-stream, so the
  // extension in the object name is the only surviving record of what the
  // bytes are. A decrypted blob built without this renders as a video with no
  // first frame and as an image that opens as a page of garbage text.
  it('names the common chat formats', () => {
    expect(mimeForPath('a/b/x.webp')).toBe('image/webp');
    expect(mimeForPath('a/b/x.jpg')).toBe('image/jpeg');
    expect(mimeForPath('a/b/x.jpeg')).toBe('image/jpeg');
    expect(mimeForPath('a/b/x.png')).toBe('image/png');
    expect(mimeForPath('a/b/x.mp4')).toBe('video/mp4');
    expect(mimeForPath('a/b/x.mov')).toBe('video/quicktime');
    expect(mimeForPath('a/b/x.m4a')).toBe('audio/mp4');
    expect(mimeForPath('a/b/x.ogg')).toBe('audio/ogg');
  });

  it('is case-insensitive, because a camera roll is not', () => {
    expect(mimeForPath('a/b/IMG_0001.JPG')).toBe('image/jpeg');
  });

  it('disambiguates webm by the message kind, which the extension cannot', () => {
    // A voice note and a video share the container. Guessing video for a
    // recording would leave the audio element unable to pick a decoder.
    expect(mimeForPath('a/b/x.webm', 'audio')).toBe('audio/webm');
    expect(mimeForPath('a/b/x.webm', 'video')).toBe('video/webm');
  });

  it('falls back to octet-stream rather than to a wrong type', () => {
    expect(mimeForPath('a/b/x.bin')).toBe('application/octet-stream');
    expect(mimeForPath('a/b/noextension')).toBe('application/octet-stream');
  });
});

describe('keyToken', () => {
  // openRows mints a fresh Uint8Array on every decrypt, and mergeMessages
  // replaces the newest row with a freshly-decrypted copy on every poll. A
  // hook keyed on the array's identity therefore re-downloaded and
  // re-decrypted its attachment every few seconds, blanking a playing video.
  it('is equal for equal bytes held in different arrays', () => {
    expect(keyToken(new Uint8Array([1, 2, 3]))).toBe(keyToken(new Uint8Array([1, 2, 3])));
  });

  it('differs for different bytes', () => {
    expect(keyToken(new Uint8Array([1, 2, 3]))).not.toBe(keyToken(new Uint8Array([1, 2, 4])));
  });

  it('does not confuse a boundary shift for the same key', () => {
    // A naive join on a delimiter-free encoding would make [1,23] and [12,3]
    // the same token.
    expect(keyToken(new Uint8Array([1, 23]))).not.toBe(keyToken(new Uint8Array([12, 3])));
  });

  it('has no token for no key', () => {
    expect(keyToken(null)).toBeNull();
    expect(keyToken(undefined)).toBeNull();
  });
});

describe('videoTrackIsUnsupported', () => {
  // Measured against Electron 43 on Linux with the same clip muxed twice: an
  // H.264 track reports 320x240 at loadedmetadata, an HEVC one reports 0x0
  // with the same duration and never fires `error`.
  it('spots a container whose video track produced no frame', () => {
    expect(videoTrackIsUnsupported({ videoWidth: 0, readyState: 4 })).toBe(true);
  });

  it('leaves a decoded video alone', () => {
    expect(videoTrackIsUnsupported({ videoWidth: 320, readyState: 1 })).toBe(false);
  });

  it('does not condemn an element that has not read its metadata yet', () => {
    // HAVE_NOTHING: videoWidth is 0 for every video at this point, including
    // the ones about to play perfectly.
    expect(videoTrackIsUnsupported({ videoWidth: 0, readyState: 0 })).toBe(false);
  });
});

describe('mediaFailureNotice', () => {
  // The whole point of the type. These three used to be one sentence, and the
  // sentence was only true of the first.
  it('says a file is gone only when it is actually gone', () => {
    expect(mediaFailureNotice('gone', 'image')).toBe('This photo is no longer available');
    expect(mediaFailureNotice('sealed', 'image')).not.toMatch(/no longer available/);
    expect(mediaFailureNotice('undecodable', 'image')).not.toMatch(/no longer available/);
  });

  it('blames this device, not the file, when there is no key', () => {
    expect(mediaFailureNotice('sealed', 'image')).toBe(
      'This device has no key for this photo'
    );
  });

  it('names an undecodable file as a limit of this build', () => {
    expect(mediaFailureNotice('undecodable', 'image')).toBe(
      "This photo's format can't be shown here"
    );
    // Played, not shown: the two time-based kinds read wrong the other way.
    expect(mediaFailureNotice('undecodable', 'video')).toBe(
      "This video's format can't be played here"
    );
    expect(mediaFailureNotice('undecodable', 'audio')).toBe(
      "This voice message's format can't be played here"
    );
  });

  it('calls each kind what the user calls it', () => {
    expect(mediaFailureNotice('gone', 'audio')).toBe('This voice message is no longer available');
    expect(mediaFailureNotice('gone', 'sticker')).toBe('This sticker is no longer available');
  });

  it('still reads as a sentence for a row whose kind was never recorded', () => {
    expect(mediaFailureNotice('gone', null)).toBe('This photo is no longer available');
  });
});
