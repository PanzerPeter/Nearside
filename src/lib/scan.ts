// Reading a QR code with the camera.
//
// Two screens scan: adding someone by their connect code, and comparing safety
// numbers. Both had their own copy of the same four-step dance (native check,
// permission, scanner module, scan) and the copies had already drifted, so a
// fix to one was a fix to one. This is the single copy.
//
// The camera, the preview and the decoding are the app's own, on every shell
// (`components/QrScanner.tsx`, `lib/qr-decode.ts`). It used to be Google's ML
// Kit code scanner, which fetched a Play Services module on first use and made
// people wait on it, failed outright on a phone without Play Services, could
// not ship in the F-Droid build at all, and reported its usage to Google.
// Every code scanned here is one this app drew — large, dark on light, quiet
// zone included — which is the easy case, and the case a plain decoder handles.
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { t, type MessageKey } from './i18n';

/** Why a scan produced nothing. `cancelled` covers the user backing out, which
 *  is not a failure and must not be reported as one. */
export type ScanFailure =
  | 'unsupported-platform'
  | 'no-camera'
  | 'permission-denied'
  | 'cancelled'
  | 'error';

export type ScanResult = { value: string } | { failure: ScanFailure };

/** What to say about each failure. Kept beside the reasons so the two screens
 *  cannot word the same problem differently. */
const SCAN_KEYS: Record<Exclude<ScanFailure, 'cancelled'>, MessageKey> = {
  'unsupported-platform': 'scan.unsupported',
  'no-camera': 'scan.noCamera',
  'permission-denied': 'scan.denied',
  error: 'scan.error',
};

/** Looked up when the failure is shown rather than at module load: this file is
 *  imported before the stored language has been read. */
export function scanMessage(failure: Exclude<ScanFailure, 'cancelled'>): string {
  return t(SCAN_KEYS[failure]);
}

/**
 * The rear camera at 1080p, both as preferences rather than requirements: a
 * laptop has only the front one and an old phone may top out lower, and either
 * still scans. The resolution is what lets a code held at arm's length keep
 * enough pixels a module (`DECODE_SIZES` below).
 */
const CAMERA: MediaTrackConstraints = {
  facingMode: { ideal: 'environment' },
  width: { ideal: 1920 },
  height: { ideal: 1080 },
};

/**
 * The sides, in pixels, the centre square is scaled to before decoding,
 * alternated frame by frame. Neither size works alone, and the reason is the
 * decoder's binarizer: it thresholds 8×8 blocks, and in a block of flat white
 * any sensor noise wider than its dynamic-range floor turns into speckle that
 * breaks the finder patterns.
 *
 * - 320: the downscale averages several camera pixels into each one, which is
 *   what removes that noise. Reads any code filling a third of the square in
 *   light dim enough that 540 reads nothing — but a code smaller than that
 *   drops under two pixels a module and is gone.
 * - 540: keeps enough pixels for a code held at arm's length, a fifth of the
 *   square, as long as the light is decent. Smaller and darker at once reads
 *   at neither size; moving closer is the answer, and the hint says so.
 *
 * The envelope is measured, not guessed: `qr-decode.test.ts` renders the codes
 * at camera resolution with noise and downsamples them the same way.
 */
export const DECODE_SIZES = [320, 540] as const;

/**
 * The square of the frame that gets decoded: the largest centred one.
 *
 * Wider than the viewfinder drawn on screen on purpose. The viewfinder is a
 * hint about where to aim, and a code held a little outside it should still
 * read rather than make somebody line it up twice.
 */
export function scanCrop(width: number, height: number): { sx: number; sy: number; side: number } {
  const side = Math.min(width, height);
  return { sx: Math.round((width - side) / 2), sy: Math.round((height - side) / 2), side };
}

/** What a `getUserMedia` rejection means for the person holding the phone. */
export function cameraFailure(err: unknown): Exclude<ScanFailure, 'cancelled'> {
  switch ((err as { name?: unknown } | null)?.name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'permission-denied';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'no-camera';
    case 'NotSupportedError':
      // A browser with the API and no capture behind it.
      return 'unsupported-platform';
    default:
      // NotReadableError among them: the camera exists but something else
      // holds it, a video call most likely.
      return 'error';
  }
}

/**
 * Opens the camera and returns the first QR code it reads.
 *
 * The permission is asked for here, at the moment of scanning, and never at
 * launch: a messenger that wants the camera on first run reads as a red flag to
 * exactly the people this app is for. On Android the WebView's request is what
 * raises the system prompt, so there is no separate permission call to make.
 *
 * The camera is opened before the scanner is drawn, so a refusal is a toast on
 * the screen the person was already looking at rather than a black overlay
 * that has to be dismissed. It is stopped here on every way out, not in the
 * component: this is the one place that sees all of them.
 */
export async function scanQr(): Promise<ScanResult> {
  if (!navigator.mediaDevices?.getUserMedia) return { failure: 'unsupported-platform' };

  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: CAMERA });
  } catch (err) {
    return { failure: cameraFailure(err) };
  }

  const host = document.createElement('div');
  let root: Root | null = null;
  try {
    // Loaded on first use: the scanner and its decoder are dead weight for
    // everyone who never taps Scan.
    const { QrScanner } = await import('../components/QrScanner');
    document.body.append(host);
    const mounted = createRoot(host);
    root = mounted;
    return await new Promise<ScanResult>((resolve) => {
      mounted.render(createElement(QrScanner, { stream, onDone: resolve }));
    });
  } catch {
    return { failure: 'error' };
  } finally {
    root?.unmount();
    host.remove();
    for (const track of stream.getTracks()) track.stop();
  }
}
