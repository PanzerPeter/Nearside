import { describe, expect, it } from 'vitest';
import {
  audioExtension,
  baseMime,
  capturedSilence,
  formatDuration,
  formatPlaybackRate,
  meterLevel,
  nextPlaybackRate,
  peakAmplitude,
  pickAudioMime,
  recordedMs,
  SILENT_PEAK,
} from './audio';

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

describe('peakAmplitude', () => {
  it('reports the loudest sample in the window, regardless of sign', () => {
    expect(peakAmplitude(Float32Array.from([0.1, -0.7, 0.3]))).toBeCloseTo(0.7);
  });

  it('reports zero for an empty window rather than -Infinity', () => {
    expect(peakAmplitude(new Float32Array(0))).toBe(0);
  });

  it('ignores non-finite samples, which some engines emit on a dropped buffer', () => {
    expect(peakAmplitude(Float32Array.from([Number.NaN, 0.2, Number.POSITIVE_INFINITY]))).toBeCloseTo(
      0.2
    );
  });
});

describe('capturedSilence', () => {
  // The emulator this app is developed against was running with -no-audio, so
  // every voice note recorded on it was several seconds of digital silence that
  // looked identical to a working one. The threshold sits above a real mic's
  // noise floor (measured around 1e-4 on a dead input) and far below speech.
  it('calls a dead input silent', () => {
    expect(capturedSilence(0)).toBe(true);
    expect(capturedSilence(0.0001)).toBe(true);
  });

  it('does not call quiet speech silent', () => {
    expect(capturedSilence(0.05)).toBe(false);
    expect(capturedSilence(0.6)).toBe(false);
  });

  it('puts the boundary where the constant says it is', () => {
    expect(capturedSilence(SILENT_PEAK)).toBe(true);
    expect(capturedSilence(SILENT_PEAK * 1.01)).toBe(false);
  });
});

describe('meterLevel', () => {
  it('maps silence to an empty meter and a loud peak to a full one', () => {
    expect(meterLevel(0)).toBe(0);
    expect(meterLevel(1)).toBe(1);
  });

  it('clamps rather than overflowing on a sample above full scale', () => {
    expect(meterLevel(3)).toBe(1);
    expect(meterLevel(-2)).toBe(0);
  });

  it('lifts quiet speech into a visible part of the bar', () => {
    // Linear amplitude would paint an ordinary speaking voice as a sliver, so
    // the meter has to be perceptual to be worth showing at all.
    expect(meterLevel(0.05)).toBeGreaterThan(0.2);
    expect(meterLevel(0.05)).toBeLessThan(meterLevel(0.5));
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

describe('nextPlaybackRate', () => {
  it('cycles normal → 1.5 → 2 → normal', () => {
    expect(nextPlaybackRate(1)).toBe(1.5);
    expect(nextPlaybackRate(1.5)).toBe(2);
    expect(nextPlaybackRate(2)).toBe(1);
  });

  // A rate held over from a build that offered a different set must not leave
  // the button cycling through nothing.
  it('returns to normal from a rate that is not on the list', () => {
    expect(nextPlaybackRate(3)).toBe(1);
  });
});

describe('formatPlaybackRate', () => {
  it('labels the button without a trailing zero', () => {
    expect(formatPlaybackRate(1)).toBe('1×');
    expect(formatPlaybackRate(1.5)).toBe('1.5×');
  });
});

describe('recordedMs', () => {
  it('counts the run in progress on top of the runs before it', () => {
    expect(recordedMs(5_000, 1_000, 3_000)).toBe(7_000);
  });

  // The gap is not in the file. A paused recording's clock has to stand still,
  // or the stored duration runs past the audio and every scrubber ends early.
  it('stands still while paused', () => {
    expect(recordedMs(5_000, null, 9_999_999)).toBe(5_000);
  });

  it('starts at zero', () => {
    expect(recordedMs(0, 1_000, 1_000)).toBe(0);
  });

  // A device whose clock steps backwards mid-recording (an NTP correction)
  // must not produce a negative length.
  it('never goes negative when the clock steps back', () => {
    expect(recordedMs(0, 5_000, 1_000)).toBe(0);
  });
});
