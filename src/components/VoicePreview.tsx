import { useEffect, useRef, useState } from 'react';
import { Mic, Pause, Play } from 'lucide-react';
import { formatDuration } from '../lib/audio';

interface VoicePreviewProps {
  /** Object URL for the staged recording, owned by the composer. */
  url: string | undefined;
  /** Wall-clock length from the recorder; see `useVoiceRecorder`. */
  durationMs: number | null;
}

/**
 * Playback for a recording that has not been sent yet.
 *
 * The staged voice note used to be a microphone glyph and a duration, so the
 * only thing the sender could check was that *something* had been recorded.
 * The meter's silence warning covers a dead microphone; it says nothing about
 * the recording that captured a pocket, the wrong room, or half a sentence —
 * all of which produce a healthy level and an unusable message. Hearing it back
 * is the only check that covers those, and it costs nothing: the bytes are
 * already on the device and nothing has been uploaded.
 *
 * Not `VoiceNote`: that one is bound to `useSignedMediaUrl` — a message id, a
 * storage path and a sealed file key, none of which exist for a local blob.
 */
export function VoicePreview({ url, durationMs }: VoicePreviewProps) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [positionMs, setPositionMs] = useState(0);
  /** Read off the element only when the recorder gave us no length. */
  const [probedMs, setProbedMs] = useState<number | null>(null);

  // Re-recording replaces the URL under this component. Nothing about the take
  // just discarded should carry over to the new one.
  useEffect(() => {
    setPlaying(false);
    setPositionMs(0);
    setProbedMs(null);
  }, [url]);

  const totalMs = durationMs ?? probedMs ?? 0;

  function toggle() {
    const el = audioRef.current;
    if (!el) return;
    if (el.paused) void el.play().catch(() => {});
    else el.pause();
  }

  function seek(e: React.ChangeEvent<HTMLInputElement>) {
    const el = audioRef.current;
    const ms = Number(e.target.value);
    setPositionMs(ms);
    if (el && totalMs > 0) el.currentTime = ms / 1000;
  }

  return (
    <div className="flex items-center gap-2.5">
      <button
        type="button"
        className="btn btn-circle btn-sm btn-primary shrink-0"
        onClick={toggle}
        disabled={!url}
        title={playing ? 'Pause' : 'Play back the recording'}
        aria-label={playing ? 'Pause playback' : 'Play back the recording'}
      >
        {playing ? (
          <Pause className="h-4 w-4 fill-current" />
        ) : (
          <Play className="ml-0.5 h-4 w-4 fill-current" />
        )}
      </button>

      <div className="min-w-0 flex-1">
        <input
          type="range"
          min={0}
          max={Math.max(totalMs, 1)}
          value={positionMs}
          onChange={seek}
          disabled={!url || totalMs <= 0}
          // The native control, for the reason `VoiceNote` keeps it: dragging,
          // keyboard seeking and screen-reader semantics all come for free.
          className="h-1 w-full cursor-pointer accent-primary"
          aria-label="Seek recording"
        />
        <p className="mt-1 flex items-center gap-1 text-xs text-base-content/60">
          <Mic className="h-3 w-3 shrink-0" />
          <span className="tabular-nums">
            {formatDuration(playing || positionMs > 0 ? positionMs : totalMs)}
          </span>
          <span className="truncate">· press Send</span>
        </p>
      </div>

      {url && (
        <audio
          ref={audioRef}
          src={url}
          preload="metadata"
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={() => {
            setPlaying(false);
            setPositionMs(0);
          }}
          onTimeUpdate={(e) => setPositionMs(e.currentTarget.currentTime * 1000)}
          onLoadedMetadata={(e) => {
            const seconds = e.currentTarget.duration;
            // A WebM straight out of MediaRecorder reports Infinity until it
            // has been fully seeked; the recorder's wall-clock covers that.
            if (durationMs === null && Number.isFinite(seconds)) setProbedMs(seconds * 1000);
          }}
        />
      )}
    </div>
  );
}
