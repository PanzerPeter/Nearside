import { useCallback, useEffect, useRef, useState } from 'react';
import {
  audioExtension,
  baseMime,
  capturedSilence,
  MAX_VOICE_MS,
  meterLevel,
  MIN_VOICE_MS,
  peakAmplitude,
  pickAudioMime,
  recordedMs,
  VOICE_BITRATE,
} from '../lib/audio';

export interface VoiceRecording {
  file: File;
  durationMs: number;
  /** True when the microphone never picked up anything above its noise floor.
   *  The file is still a valid recording of nothing, so the caller has to say
   *  so rather than let the user send silence believing it worked. */
  silent: boolean;
}

/** Why a recording could not start. Mapped to copy by the caller. */
export type VoiceRecorderError = 'denied' | 'unsupported' | 'failed';

export interface VoiceRecorder {
  recording: boolean;
  /** True while recording is held: the mic stays open, the file stops growing.
   *  Only reachable once the recording has been locked — a finger on the
   *  button has nothing to press pause with. */
  paused: boolean;
  /** Time since `start`, updated a few times a second for the live timer. */
  elapsedMs: number;
  /** Current input loudness, 0..1, for the live meter. Zero whenever the
   *  browser gives us no way to measure it. */
  level: number;
  start: () => Promise<VoiceRecorderError | null>;
  /** Hold and release the capture. No-ops when the engine cannot pause a
   *  MediaRecorder, which leaves a recording that simply keeps running. */
  pause: () => void;
  resume: () => void;
  /** Finish and deliver through `onComplete`. */
  stop: () => void;
  /** Discard: no `onComplete` call, mic released. */
  cancel: () => void;
}

const TICK_MS = 100;

type WebkitWindow = Window & { webkitAudioContext?: typeof AudioContext };

/**
 * Microphone recording for voice messages.
 *
 * `onComplete` receives the finished recording, or null when it was too short
 * to be anything but a mis-tap. It also delivers the auto-stop at
 * MAX_VOICE_MS, so every way a recording can end well arrives through one
 * callback and the caller never watches the clock.
 *
 * The mic track is stopped on every exit path, including unmount. A live track
 * leaves the browser's recording indicator on and, on mobile, holds audio
 * focus away from everything else.
 *
 * `pause` holds the capture without closing the microphone, so a long message
 * can be assembled in takes. The elapsed clock and the duration written to the
 * message row both count only what is in the file — see `recordedMs`.
 *
 * The input is metered while recording. That drives the live level bar, and it
 * is the only way to tell a working microphone from one that is muted, missing
 * or unwired: all three produce a valid stream and a valid file, and only the
 * amplitude says which you got.
 */
export function useVoiceRecorder(
  onComplete: (recording: VoiceRecording | null) => void
): VoiceRecorder {
  const [recording, setRecording] = useState(false);
  const [paused, setPaused] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [level, setLevel] = useState(0);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  /** When the current run of recording began, or null while paused. */
  const segmentStartRef = useRef<number | null>(null);
  /** Everything recorded before the current run. */
  const accumulatedRef = useRef(0);
  const cancelledRef = useRef(false);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Metering. The context is separate from the one `sound.ts` owns for the
  // notification chime: this one exists only while the mic is open, and closing
  // it with the track is what releases the audio hardware promptly.
  const meterRef = useRef<{ ctx: AudioContext; analyser: AnalyserNode } | null>(null);
  // Explicitly backed by an ArrayBuffer: `getFloatTimeDomainData` will not
  // accept a view that might sit over a SharedArrayBuffer.
  const samplesRef = useRef<Float32Array<ArrayBuffer> | null>(null);
  const loudestRef = useRef(0);

  // Read from the recorder's `stop` handler, which closes over the callback as
  // it was when recording began — a stale one would post the recording into an
  // unmounted parent's state.
  const completeRef = useRef(onComplete);
  useEffect(() => {
    completeRef.current = onComplete;
  }, [onComplete]);

  const releaseStream = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    const meter = meterRef.current;
    meterRef.current = null;
    samplesRef.current = null;
    // Best effort: a context that refuses to close is not a reason to fail a
    // recording the user has already finished.
    meter?.ctx.close().catch(() => {});
  }, []);

  /** Attach a meter to `stream`, or leave metering off if the engine has no
   *  Web Audio. Recording still works without it; only the bar and the silence
   *  warning are lost. */
  const startMeter = useCallback((stream: MediaStream) => {
    loudestRef.current = 0;
    setLevel(0);
    const Ctor = window.AudioContext ?? (window as WebkitWindow).webkitAudioContext;
    if (!Ctor) return;
    try {
      const ctx = new Ctor();
      // A context that starts suspended reads back nothing but zeros, which
      // would report a working microphone as silent.
      void ctx.resume().catch(() => {});
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      ctx.createMediaStreamSource(stream).connect(analyser);
      meterRef.current = { ctx, analyser };
      samplesRef.current = new Float32Array(analyser.fftSize);
    } catch {
      meterRef.current = null;
    }
  }, []);

  /** Read one window, feed the live bar, and remember the loudest moment of
   *  the whole recording. */
  const sampleMeter = useCallback(() => {
    const meter = meterRef.current;
    const samples = samplesRef.current;
    if (!meter || !samples) return;
    meter.analyser.getFloatTimeDomainData(samples);
    const peak = peakAmplitude(samples);
    if (peak > loudestRef.current) loudestRef.current = peak;
    setLevel(meterLevel(peak));
  }, []);

  const clearTick = useCallback(() => {
    if (tickRef.current !== null) {
      clearInterval(tickRef.current);
      tickRef.current = null;
    }
  }, []);

  const start = useCallback(async (): Promise<VoiceRecorderError | null> => {
    if (recorderRef.current) return null;

    const mime = pickAudioMime();
    if (!mime || !navigator.mediaDevices?.getUserMedia) return 'unsupported';

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch (err) {
      const name = (err as DOMException | undefined)?.name;
      return name === 'NotAllowedError' || name === 'SecurityError' ? 'denied' : 'failed';
    }

    let recorder: MediaRecorder;
    try {
      recorder = new MediaRecorder(stream, {
        mimeType: mime,
        audioBitsPerSecond: VOICE_BITRATE,
      });
    } catch {
      stream.getTracks().forEach((track) => track.stop());
      return 'failed';
    }

    streamRef.current = stream;
    recorderRef.current = recorder;
    chunksRef.current = [];
    cancelledRef.current = false;
    segmentStartRef.current = Date.now();
    accumulatedRef.current = 0;

    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunksRef.current.push(event.data);
    };

    recorder.onstop = () => {
      // Wall-clock, not the container's own timing: a WebM from MediaRecorder
      // reports an Infinite duration until it has been fully seeked, which is
      // exactly the number the UI needs up front. Time spent paused is not in
      // the file, so it is not in this number either.
      const durationMs = recordedMs(accumulatedRef.current, segmentStartRef.current, Date.now());
      const chunks = chunksRef.current;
      const cancelled = cancelledRef.current;
      const loudest = loudestRef.current;
      // A recorder that never metered anything (no Web Audio) must not be
      // reported as silence; only a meter that ran and saw nothing counts.
      const metered = meterRef.current !== null;

      chunksRef.current = [];
      recorderRef.current = null;
      segmentStartRef.current = null;
      accumulatedRef.current = 0;
      releaseStream();
      clearTick();
      setRecording(false);
      setPaused(false);
      setElapsedMs(0);
      setLevel(0);

      if (cancelled) return;
      if (durationMs < MIN_VOICE_MS || chunks.length === 0) {
        completeRef.current(null);
        return;
      }

      const type = baseMime(mime);
      const blob = new Blob(chunks, { type });
      const file = new File([blob], `voice-${Date.now()}.${audioExtension(mime)}`, {
        type,
        lastModified: Date.now(),
      });
      completeRef.current({
        file,
        durationMs: Math.min(durationMs, MAX_VOICE_MS),
        silent: metered && capturedSilence(loudest),
      });
    };

    startMeter(stream);
    recorder.start(250);
    setRecording(true);
    setElapsedMs(0);

    tickRef.current = setInterval(() => {
      const elapsed = recordedMs(accumulatedRef.current, segmentStartRef.current, Date.now());
      setElapsedMs(elapsed);
      // A paused recorder is metering a microphone whose input is going
      // nowhere; a bar that still moved would say the opposite.
      if (segmentStartRef.current === null) setLevel(0);
      else sampleMeter();
      if (elapsed >= MAX_VOICE_MS && recorderRef.current?.state === 'recording') {
        recorderRef.current.stop();
      }
    }, TICK_MS);

    return null;
  }, [clearTick, releaseStream, sampleMeter, startMeter]);

  const stop = useCallback(() => {
    // 'paused' as well as 'recording': stopping from a hold is the ordinary way
    // a locked recording ends, and MediaRecorder flushes what it has either
    // way.
    const state = recorderRef.current?.state;
    if (state === 'recording' || state === 'paused') recorderRef.current?.stop();
  }, []);

  const pause = useCallback(() => {
    const recorder = recorderRef.current;
    // `pause` is optional in the MediaRecorder spec and absent on some older
    // WebViews. Without it the recording keeps running, which is the honest
    // failure — the caller hides the button when this reports back unchanged.
    if (recorder?.state !== 'recording' || typeof recorder.pause !== 'function') return;
    recorder.pause();
    accumulatedRef.current = recordedMs(accumulatedRef.current, segmentStartRef.current, Date.now());
    segmentStartRef.current = null;
    setPaused(true);
    setLevel(0);
  }, []);

  const resume = useCallback(() => {
    const recorder = recorderRef.current;
    if (recorder?.state !== 'paused' || typeof recorder.resume !== 'function') return;
    recorder.resume();
    segmentStartRef.current = Date.now();
    setPaused(false);
  }, []);

  const cancel = useCallback(() => {
    cancelledRef.current = true;
    const state = recorderRef.current?.state;
    if (state === 'recording' || state === 'paused') {
      recorderRef.current?.stop();
    } else {
      // Nothing in flight to unwind through `onstop`.
      segmentStartRef.current = null;
      accumulatedRef.current = 0;
      releaseStream();
      clearTick();
      setRecording(false);
      setPaused(false);
      setElapsedMs(0);
      setLevel(0);
    }
  }, [clearTick, releaseStream]);

  useEffect(() => {
    return () => {
      cancelledRef.current = true;
      const state = recorderRef.current?.state;
      if (state === 'recording' || state === 'paused') recorderRef.current?.stop();
      recorderRef.current = null;
      releaseStream();
      clearTick();
    };
  }, [clearTick, releaseStream]);

  return { recording, paused, elapsedMs, level, start, pause, resume, stop, cancel };
}
