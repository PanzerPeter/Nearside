// Reading a QR code with the camera.
//
// Two screens scan: adding someone by their connect code, and comparing safety
// numbers. Both had their own copy of the same four-step dance (native check,
// permission, scanner module, scan) and the copies had already drifted, so a
// fix to one was a fix to one. This is the single copy.
import { Capacitor } from '@capacitor/core';
import {
  BarcodeFormat,
  BarcodeScanner,
  GoogleBarcodeScannerModuleInstallState,
} from '@capacitor-mlkit/barcode-scanning';
import { isMobileNative } from './platform';

/** Why a scan produced nothing. `cancelled` covers the user backing out, which
 *  is not a failure and must not be reported as one. */
export type ScanFailure =
  | 'unsupported-platform'
  | 'no-camera'
  | 'permission-denied'
  | 'scanner-unavailable'
  | 'cancelled'
  | 'error';

export type ScanResult = { value: string } | { failure: ScanFailure };

/** What to say about each failure. Kept beside the reasons so the two screens
 *  cannot word the same problem differently. */
export const SCAN_MESSAGES: Record<Exclude<ScanFailure, 'cancelled'>, string> = {
  'unsupported-platform': 'Scanning needs the app. Type the code instead.',
  'no-camera': 'This device has no camera to scan with.',
  'permission-denied': 'Nearside needs the camera to scan a code.',
  'scanner-unavailable': 'The scanner could not install. Type the code instead.',
  error: 'Could not open the camera.',
};

/** How long to wait for Play Services to fetch the scanner module before
 *  giving up and pointing at the typed code. Long enough for a slow
 *  connection, short enough that nobody sits on a spinner wondering. */
const MODULE_INSTALL_TIMEOUT_MS = 60_000;

/**
 * Downloads the Google Barcode Scanner module and resolves once it is usable.
 *
 * The install call itself resolves the moment the request is queued, which is
 * why the first version of this told the user to "try again in a moment" and
 * left them to guess when that was. Play Services emits progress events; this
 * waits for one that means finished, and re-checks availability either way
 * because a module already present emits nothing at all.
 */
async function ensureScannerModule(): Promise<boolean> {
  // Android only. The module is a Play Services download; on iOS the scanner
  // is compiled into the app and these three calls are all unimplemented —
  // the first one throws, the catch in `scanQr` swallows it, and scanning a
  // code reports "Could not open the camera" on a device whose camera is fine.
  if (Capacitor.getPlatform() !== 'android') return true;

  const { available } = await BarcodeScanner.isGoogleBarcodeScannerModuleAvailable();
  if (available) return true;

  const { COMPLETED, CANCELED, FAILED } = GoogleBarcodeScannerModuleInstallState;
  let settle = () => {};
  const finished = new Promise<void>((resolve) => {
    settle = resolve;
  });
  const timer = setTimeout(() => settle(), MODULE_INSTALL_TIMEOUT_MS);

  const listener = await BarcodeScanner.addListener(
    'googleBarcodeScannerModuleInstallProgress',
    (event) => {
      if (event.state === COMPLETED || event.state === CANCELED || event.state === FAILED) settle();
    }
  );

  try {
    await BarcodeScanner.installGoogleBarcodeScannerModule();
    await finished;
  } finally {
    clearTimeout(timer);
    await listener.remove();
  }

  // Asked again rather than trusted: COMPLETED is the module's word for it,
  // and this is the check the scan itself depends on.
  return (await BarcodeScanner.isGoogleBarcodeScannerModuleAvailable()).available;
}

/**
 * Opens the camera and returns the first QR code it reads.
 *
 * The permission is asked for here, at the moment of scanning, and never at
 * launch: a messenger that wants the camera on first run reads as a red flag to
 * exactly the people this app is for.
 */
export async function scanQr(): Promise<ScanResult> {
  if (!isMobileNative()) return { failure: 'unsupported-platform' };

  try {
    const { supported } = await BarcodeScanner.isSupported();
    if (!supported) return { failure: 'no-camera' };

    const { camera } = await BarcodeScanner.requestPermissions();
    if (camera !== 'granted' && camera !== 'limited') return { failure: 'permission-denied' };

    // A device without Play Services — an emulator image, a de-Googled phone —
    // never gets this module. Saying so points at the typed code, which is the
    // path that still works there.
    if (!(await ensureScannerModule())) return { failure: 'scanner-unavailable' };

    const { barcodes } = await BarcodeScanner.scan({ formats: [BarcodeFormat.QrCode] });
    const value = barcodes[0]?.rawValue;
    return value ? { value } : { failure: 'cancelled' };
  } catch {
    return { failure: 'error' };
  }
}
