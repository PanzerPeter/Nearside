import { useEffect, useRef, useState } from 'react';
import { Mic, Pause, Play } from 'lucide-react';
import { formatDuration } from '../lib/audio';
import { useSignedMediaUrl } from '../hooks/useSignedMediaUrl';

interface VoiceNoteProps {
  path: string;
  /** Recorded length from the message row; see `Message.media_duration_ms`. */
  durationMs: number | null;
}

/**
 * Player for a voice message stored in the private `chat-media` bucket.
 *
 * Colours come from `currentColor`, so the same component reads correctly in
 * both bubble palettes (primary for your own messages, neutral for the
 * friend's) without being told which one it is in.
 */
export function VoiceNote({ path, durationMs }: VoiceNoteProps) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const { url, failed, reload } = useSignedMediaUrl(path);
  const [playing, setPlaying] = useState(false);
  const [positionMs, setPositionMs] = useState(0);
  // Filled in from the element only when the row has no stored duration.
  const [probedMs, setProbedMs] = useState<number | null>(null);

  // The URL is the hook's business; the playback state on top of it is this
  // component's, and a different recording must not inherit the last one's
  // position or probed length.
  useEffect(() => {
    setPlaying(false);
    setPositionMs(0);
    setProbedMs(null);
  }, [path]);

  const totalMs = durationMs ?? probedMs ?? 0;

  function toggle(e: React.MouseEvent) {
    // The bubble behind this treats a tap as "show the reaction toolbar".
    e.stopPropagation();
    const el = audioRef.current;
    if (!el) return;
    // A play() that rejects is most often a source the element could not load
    // — an expired signature among them — so it goes through the same one-shot
    // re-sign as an `error` event rather than straight to "unavailable".
    if (el.paused) void el.play().catch(reload);
    else el.pause();
  }

  function seek(e: React.ChangeEvent<HTMLInputElement>) {
    const el = audioRef.current;
    const ms = Number(e.target.value);
    setPositionMs(ms);
    if (el && totalMs > 0) el.currentTime = ms / 1000;
  }

  if (failed) {
    return (
      <div className="flex items-center gap-2 py-2 text-xs opacity-70">
        <Mic className="h-4 w-4" />
        Voice message no longer available
      </div>
    );
  }

  return (
    <div className="flex w-56 max-w-full items-center gap-2.5 py-1 sm:w-64">
      <button
        type="button"
        // Inline `color-mix` tints the button with the bubble's own colour;
        // the class behind it is the flat fallback a browser without
        // `color-mix` keeps, since an invalid inline value is simply dropped.
        style={{ backgroundColor: 'color-mix(in srgb, currentColor 18%, transparent)' }}
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[rgba(127,127,127,0.28)] transition-opacity disabled:opacity-50"
        onClick={toggle}
        disabled={!url}
        title={playing ? 'Pause' : 'Play'}
        aria-label={playing ? 'Pause voice message' : 'Play voice message'}
      >
        {!url ? (
          <span className="loading loading-spinner loading-xs" />
        ) : playing ? (
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
          // The native control is kept on purpose: `accent-color` tints it to
          // the bubble's palette, and dragging, keyboard seeking and screen
          // reader semantics all come for free. A custom track would have to
          // reimplement each of those to look slightly thinner.
          style={{ accentColor: 'currentColor' }}
          className="h-1 w-full cursor-pointer"
          aria-label="Seek voice message"
          // Dragging the slider is a horizontal gesture inside a bubble that
          // treats horizontal gestures as swipe-to-reply. Without this, seeking
          // through a voice note would arm a reply to it.
          onPointerDown={(e) => e.stopPropagation()}
          onPointerMove={(e) => e.stopPropagation()}
          onPointerUp={(e) => e.stopPropagation()}
        />
        <div className="mt-1 flex items-center gap-1 text-[0.65rem] opacity-75">
          <Mic className="h-3 w-3" />
          <span>{formatDuration(playing || positionMs > 0 ? positionMs : totalMs)}</span>
        </div>
      </div>

      {url && (
        <audio
          ref={audioRef}
          src={url}
          // The row already carries the duration, so nothing needs fetching
          // until the message is actually played.
          preload="none"
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={() => {
            setPlaying(false);
            setPositionMs(0);
          }}
          onTimeUpdate={(e) => setPositionMs(e.currentTarget.currentTime * 1000)}
          onLoadedMetadata={(e) => {
            const seconds = e.currentTarget.duration;
            // WebM from MediaRecorder reports Infinity here — the stored
            // duration is what covers that case.
            if (durationMs === null && Number.isFinite(seconds)) setProbedMs(seconds * 1000);
          }}
          onError={reload}
        />
      )}
    </div>
  );
}
