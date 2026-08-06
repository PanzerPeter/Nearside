import { describe, expect, it } from 'vitest';
import { audioExtension, baseMime, formatDuration, pickAudioMime } from './audio';

describe('pickAudioMime', () => {
  it('prefers Opus in WebM where it is available', () => {
    expect(pickAudioMime(() => true)).toBe('audio/webm;codecs=opus');
  });

  it('falls back to MP4 on Safari, which records AAC only', () => {
    expect(pickAudioMime((mime) => mime === 'audio/mp4')).toBe('audio/mp4');
  });

  it('falls back to Ogg when only that container carries Opus', () => {
    expect(pickAudioMime((mime) => mime.startsWith('audio/ogg'))).toBe('audio/ogg;codecs=opus');
  });

  it('returns null when the browser records nothing it offers', () => {
    expect(pickAudioMime(() => false)).toBeNull();
  });
});

describe('baseMime', () => {
  it('strips codec parameters, which storage allow-lists do not match on', () => {
    expect(baseMime('audio/webm;codecs=opus')).toBe('audio/webm');
  });

  it('normalises casing and stray whitespace', () => {
    expect(baseMime('  AUDIO/MP4 ; codecs=mp4a.40.2')).toBe('audio/mp4');
  });

  it('passes a bare mime through', () => {
    expect(baseMime('audio/ogg')).toBe('audio/ogg');
  });
});

describe('audioExtension', () => {
  it('maps each recorder container to its file extension', () => {
    expect(audioExtension('audio/webm;codecs=opus')).toBe('webm');
    expect(audioExtension('audio/ogg;codecs=opus')).toBe('ogg');
    expect(audioExtension('audio/mp4')).toBe('m4a');
    expect(audioExtension('audio/aac')).toBe('aac');
    expect(audioExtension('audio/mpeg')).toBe('mp3');
  });

  it('defaults to webm for anything unrecognised, rather than an empty suffix', () => {
    expect(audioExtension('audio/exotic')).toBe('webm');
  });
});

describe('formatDuration', () => {
  it('renders m:ss with a padded seconds field', () => {
    expect(formatDuration(0)).toBe('0:00');
    expect(formatDuration(9_000)).toBe('0:09');
    expect(formatDuration(65_000)).toBe('1:05');
    expect(formatDuration(120_000)).toBe('2:00');
  });

  it('floors rather than rounds, so a timer never shows a length not yet reached', () => {
    expect(formatDuration(1_999)).toBe('0:01');
  });

  it('treats negative and non-finite input as zero', () => {
    expect(formatDuration(-500)).toBe('0:00');
    expect(formatDuration(Number.NaN)).toBe('0:00');
    expect(formatDuration(Number.POSITIVE_INFINITY)).toBe('0:00');
  });
});
