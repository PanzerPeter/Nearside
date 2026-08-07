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
  /** Time since `start`, updated a few times a second for the live timer. */
  elapsedMs: number;
  /** Current input loudness, 0..1, for the live meter. Zero whenever the
   *  browser gives us no way to measure it. */
  level: number;
  start: () => Promise<VoiceRecorderError | null>;
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
 * to be anything but a mis-tap. It is also what delivers the auto-stop at
 * MAX_VOICE_MS, so the caller does not have to watch the clock: every way a
 * recording can end well arrives through this one callback.
 *
 * The mic track is stopped on every exit path — finish, cancel, error, and
 * unmount — because a live track leaves the browser's recording indicator on
 * and, on mobile, holds audio focus away from everything else.
 *
 * The input is metered while it records. That drives the live level bar, and it
 * is also the only way to tell a working microphone from one that is muted,
 * missing or unwired: all three produce a valid stream and a valid file, and
 * only the amplitude says which you got.
 */
export function useVoiceRecorder(
  onComplete: (recording: VoiceRecording | null) => void
): VoiceRecorder {
  const [recording, setRecording] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [level, setLevel] = useState(0);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const startedAtRef = useRef(0);
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
    startedAtRef.current = Date.now();

    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunksRef.current.push(event.data);
    };

    recorder.onstop = () => {
      // Wall-clock, not the container's own timing: a WebM from MediaRecorder
      // reports an Infinite duration until it has been fully seeked, which is
      // exactly the number the UI needs up front.
      const durationMs = Date.now() - startedAtRef.current;
      const chunks = chunksRef.current;
      const cancelled = cancelledRef.current;
      const loudest = loudestRef.current;
      // A recorder that never metered anything (no Web Audio) must not be
      // reported as silence; only a meter that ran and saw nothing counts.
      const metered = meterRef.current !== null;

      chunksRef.current = [];
      recorderRef.current = null;
      releaseStream();
      clearTick();
      setRecording(false);
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
      const elapsed = Date.now() - startedAtRef.current;
      setElapsedMs(elapsed);
      sampleMeter();
      if (elapsed >= MAX_VOICE_MS && recorderRef.current?.state === 'recording') {
        recorderRef.current.stop();
      }
    }, TICK_MS);

    return null;
  }, [clearTick, releaseStream, sampleMeter, startMeter]);

  const stop = useCallback(() => {
    if (recorderRef.current?.state === 'recording') recorderRef.current.stop();
  }, []);

  const cancel = useCallback(() => {
    cancelledRef.current = true;
    if (recorderRef.current?.state === 'recording') {
      recorderRef.current.stop();
    } else {
      // Nothing in flight to unwind through `onstop`.
      releaseStream();
      clearTick();
      setRecording(false);
      setElapsedMs(0);
      setLevel(0);
    }
  }, [clearTick, releaseStream]);

  useEffect(() => {
    return () => {
      cancelledRef.current = true;
      if (recorderRef.current?.state === 'recording') recorderRef.current.stop();
      recorderRef.current = null;
      releaseStream();
      clearTick();
    };
  }, [clearTick, releaseStream]);

  return { recording, elapsedMs, level, start, stop, cancel };
}
