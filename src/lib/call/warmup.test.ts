import { afterEach, describe, expect, it, vi } from 'vitest';
import { holdWarmMedia, primeMedia, releaseWarmMedia, takeWarmMedia } from './warmup';

/** A stream that reports whether anything stopped it. */
function fakeStream() {
  const track = { stop: vi.fn() };
  return {
    stream: { getTracks: () => [track] } as unknown as MediaStream,
    track,
  };
}

afterEach(() => {
  releaseWarmMedia();
});

describe('priming', () => {
  it('captures once and hands the same capture to the call', async () => {
    const { stream } = fakeStream();
    const getMedia = vi.fn().mockResolvedValue(stream);
    primeMedia('voice', getMedia);
    expect(getMedia).toHaveBeenCalledTimes(1);
    await expect(takeWarmMedia('voice')).resolves.toBe(stream);
  });

  it('asks for the microphone alone on a voice call', () => {
    const getMedia = vi.fn().mockResolvedValue(fakeStream().stream);
    primeMedia('voice', getMedia);
    expect(getMedia.mock.calls[0][0]).toMatchObject({ video: false });
    releaseWarmMedia();
    primeMedia('video', getMedia);
    expect(getMedia.mock.calls[1][0].video).toBeTruthy();
  });

  it('does not open a second microphone when primed twice', () => {
    const getMedia = vi.fn().mockResolvedValue(fakeStream().stream);
    primeMedia('voice', getMedia);
    primeMedia('voice', getMedia);
    expect(getMedia).toHaveBeenCalledTimes(1);
  });

  it('gives the capture up only once', async () => {
    const getMedia = vi.fn().mockResolvedValue(fakeStream().stream);
    primeMedia('voice', getMedia);
    expect(takeWarmMedia('voice')).not.toBeNull();
    // A second call is a different call. Handing it a stream this one is
    // already using would take the microphone out from under the live one.
    expect(takeWarmMedia('voice')).toBeNull();
  });

  it('captures normally when nothing was primed', () => {
    expect(takeWarmMedia('voice')).toBeNull();
  });
});

describe('a capture that already happened', () => {
  it('goes to the call that parked it', async () => {
    const { stream } = fakeStream();
    holdWarmMedia('video', stream);
    await expect(takeWarmMedia('video')).resolves.toBe(stream);
  });

  it('replaces anything primed before it', async () => {
    const first = fakeStream();
    primeMedia('voice', vi.fn().mockResolvedValue(first.stream));
    holdWarmMedia('voice', fakeStream().stream);
    await Promise.resolve();
    await Promise.resolve();
    expect(first.track.stop).toHaveBeenCalled();
  });
});

describe('releasing', () => {
  it('stops a capture nobody claimed', async () => {
    const { stream, track } = fakeStream();
    primeMedia('voice', vi.fn().mockResolvedValue(stream));
    releaseWarmMedia();
    // The stop happens when the capture resolves, which is a microtask away.
    await Promise.resolve();
    await Promise.resolve();
    expect(track.stop).toHaveBeenCalled();
  });

  it('stops a capture primed for the wrong kind rather than holding it', async () => {
    // The ring notification says "video" and the offer that arrives says
    // "voice". The camera must not stay open for the length of the call.
    const { stream, track } = fakeStream();
    primeMedia('video', vi.fn().mockResolvedValue(stream));
    expect(takeWarmMedia('voice')).toBeNull();
    await Promise.resolve();
    await Promise.resolve();
    expect(track.stop).toHaveBeenCalled();
  });

  it('survives a capture that was refused', async () => {
    primeMedia('voice', vi.fn().mockRejectedValue(new Error('denied')));
    expect(() => releaseWarmMedia()).not.toThrow();
    await Promise.resolve();
  });

  it('reports a refused capture to the call, which falls back', async () => {
    primeMedia('voice', vi.fn().mockRejectedValue(new Error('denied')));
    const claimed = takeWarmMedia('voice');
    expect(claimed).not.toBeNull();
    await expect(claimed).rejects.toThrow('denied');
  });
});
