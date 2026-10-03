// Reading a QR code out of one camera frame.
//
// The other direction of `lib/qr.ts`, kept out of it so the decoder is only
// loaded when somebody opens the scanner — `qr.ts` is on the connect screen's
// first paint. Pure, and imported by nothing but `lib/qr-worker.ts` and its
// test: anything on the main thread that imported this would ship a second
// copy of the decoder beside the worker's. Which part of a frame gets decoded,
// and at what size, is `lib/scan.ts`.
import jsQR from 'jsqr';

/**
 * The text of the QR code in an RGBA frame, or null when there isn't one.
 *
 * `dontInvert`: every code this app scans is one it drew itself, dark on light
 * whatever the theme (`QrCode.tsx` says why), so looking for an inverted code
 * as well would double the work of every attempt to find something that is
 * never there.
 */
export function decodeQr(data: Uint8ClampedArray, width: number, height: number): string | null {
  return jsQR(data, width, height, { inversionAttempts: 'dontInvert' })?.data || null;
}
