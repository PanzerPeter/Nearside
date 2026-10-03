import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Flashlight, FlashlightOff, X } from 'lucide-react';
import { DECODE_SIZES, scanCrop, type ScanResult } from '../lib/scan';
import { useMobileBackClose } from '../hooks/useMobileBackClose';
import { useT } from '../hooks/useT';

/** Pause between decode attempts. The decoder answers in a few milliseconds
 *  when a code is there, so this is what sets how fast one reads; shorter only
 *  spends battery re-reading frames the camera has not replaced yet. */
const ATTEMPT_GAP_MS = 60;

interface QrScannerProps {
  /** Opened, and stopped, by `scanQr` — see there for why not here. */
  stream: MediaStream;
  /** Called on a read and on every way out. Only the first call counts: it
   *  settles a promise. */
  onDone: (result: ScanResult) => void;
}

/**
 * The camera, full screen, until a QR code reads.
 *
 * A `<dialog>` opened with `showModal()`, like `Modal`, and for a reason
 * beyond consistency: both screens that scan are already inside one, in the
 * top layer, where no z-index reaches. Anything else would draw underneath
 * the modal it was opened from and be inert besides.
 *
 * Mounted on its own root by `scanQr`, so it holds no app state and needs none.
 */
export function QrScanner({ stream, onDone }: QrScannerProps) {
  const t = useT();
  const dialog = useRef<HTMLDialogElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;
  // null until the camera says it has a light, and for good if it never does.
  const [torch, setTorch] = useState<boolean | null>(null);

  const track = stream.getVideoTracks()[0];
  // The front camera is shown mirrored, the way every camera app shows it, or
  // moving the code left moves it right on screen. Only the picture: the frames
  // handed to the decoder come from the video, which CSS does not touch, and a
  // mirrored QR code does not decode.
  const mirrored = track?.getSettings().facingMode !== 'environment';

  const cancel = () => onDoneRef.current({ failure: 'cancelled' });
  useMobileBackClose(true, cancel);

  useLayoutEffect(() => {
    const element = dialog.current;
    if (!element) return;
    element.showModal();
    // Escape closes a modal dialog by itself; `close` is the one event that
    // covers it and the close button both.
    const onClose = () => onDoneRef.current({ failure: 'cancelled' });
    element.addEventListener('close', onClose);
    return () => {
      element.removeEventListener('close', onClose);
      // Layout cleanup, as in `Modal`: the only point at which the dialog is
      // still attached, which is what lets close() put focus back on the
      // button that opened the scanner.
      if (element.open) element.close();
    };
  }, []);

  useEffect(() => {
    const element = video.current;
    if (!element) return;
    element.srcObject = stream;
    void element.play().catch(() => {});

    const worker = new Worker(new URL('../lib/qr-worker.ts', import.meta.url), { type: 'module' });
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d', { willReadFrequently: true });
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const next = () => {
      timer = setTimeout(grab, ATTEMPT_GAP_MS);
    };

    // One frame at a time: the next is grabbed only once the worker has
    // answered the last, so a slow phone decodes less often rather than
    // queueing frames it will never catch up on.
    function grab() {
      if (!context || element!.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return next();
      const { sx, sy, side } = scanCrop(element!.videoWidth, element!.videoHeight);
      const size = DECODE_SIZES[attempt++ % DECODE_SIZES.length];
      if (canvas.width !== size) canvas.width = canvas.height = size;
      // Resizing a canvas resets its context, so this is set every time. High
      // quality is the averaging `DECODE_SIZES` counts on to wash out noise.
      context.imageSmoothingQuality = 'high';
      context.drawImage(element!, sx, sy, side, side, 0, 0, size, size);
      const { data } = context.getImageData(0, 0, size, size);
      worker.postMessage({ data, width: size, height: size }, [data.buffer]);
    }

    worker.onmessage = (event: MessageEvent<string | null>) => {
      if (event.data) onDoneRef.current({ value: event.data });
      else next();
    };
    worker.onerror = () => onDoneRef.current({ failure: 'error' });

    // Asked once the picture is flowing: before that, Android reports the
    // track's capabilities without the light it has.
    const onData = () => {
      const capabilities = track?.getCapabilities?.() as { torch?: boolean } | undefined;
      if (capabilities?.torch) setTorch(false);
    };
    element.addEventListener('loadeddata', onData, { once: true });

    // Backgrounding ends the scan. The system takes the camera away from a
    // backgrounded app anyway, which left a black preview to come back to;
    // closing instead also means the camera is never on behind somebody's back.
    const onHidden = () => {
      if (document.visibilityState === 'hidden') onDoneRef.current({ failure: 'cancelled' });
    };
    document.addEventListener('visibilitychange', onHidden);
    const onEnded = () => onDoneRef.current({ failure: 'error' });
    track?.addEventListener('ended', onEnded);

    next();
    return () => {
      clearTimeout(timer);
      worker.terminate();
      element.removeEventListener('loadeddata', onData);
      document.removeEventListener('visibilitychange', onHidden);
      track?.removeEventListener('ended', onEnded);
    };
  }, [stream, track]);

  async function toggleTorch() {
    if (!track || torch === null) return;
    try {
      await track.applyConstraints({ advanced: [{ torch: !torch } as MediaTrackConstraintSet] });
      setTorch(!torch);
    } catch {
      // Claimed and then refused, which some phones do: stop offering it.
      setTorch(null);
    }
  }

  // White on glass over the picture, like the call controls: the theme's
  // colours are the wrong contrast reference against a camera feed.
  const glass =
    'w-12 h-12 rounded-full flex items-center justify-center bg-white/15 text-white backdrop-blur-sm hover:bg-white/25 transition-colors';

  return (
    <dialog
      ref={dialog}
      aria-label={t('scan.title')}
      className="fixed inset-0 m-0 h-full max-h-none w-full max-w-none overflow-hidden border-0 bg-black p-0 text-white"
    >
      <video
        ref={video}
        muted
        playsInline
        autoPlay
        className={`absolute inset-0 h-full w-full object-cover${mirrored ? ' -scale-x-100' : ''}`}
      />

      {/* The viewfinder; its shadow is the dimming around it. Always inside
          the square `scanCrop` decodes, which is wider, so lining a code up
          here can never put it out of reach. */}
      <div
        aria-hidden
        className="absolute left-1/2 top-1/2 size-[70vmin] -translate-x-1/2 -translate-y-1/2 rounded-3xl border-2 border-white/80 shadow-[0_0_0_100vmax_rgba(0,0,0,0.55)]"
      />

      <div
        className="absolute inset-x-0 top-0 flex items-center justify-between px-4"
        style={{ paddingTop: 'calc(var(--safe-top) + 1rem)' }}
      >
        <button
          type="button"
          className={glass}
          onClick={() => dialog.current?.close()}
          aria-label={t('common.close')}
          title={t('common.close')}
        >
          <X className="w-5 h-5" />
        </button>
        {torch !== null && (
          <button
            type="button"
            className={glass}
            onClick={() => void toggleTorch()}
            aria-label={t('scan.torch')}
            aria-pressed={torch}
            title={t('scan.torch')}
          >
            {torch ? <FlashlightOff className="w-5 h-5" /> : <Flashlight className="w-5 h-5" />}
          </button>
        )}
      </div>

      <p
        className="absolute inset-x-0 bottom-0 px-6 text-center text-body text-white/90"
        style={{ paddingBottom: 'calc(var(--safe-bottom) + 2.5rem)' }}
      >
        {t('scan.hint')}
      </p>
    </dialog>
  );
}
