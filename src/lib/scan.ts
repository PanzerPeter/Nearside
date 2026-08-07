// Reading a QR code with the camera.
//
// Two screens scan: adding someone by their connect code, and comparing safety
// numbers. Both had their own copy of the same four-step dance (native check,
// permission, scanner module, scan) and the copies had already drifted, so a
// fix to one was a fix to one. This is the single copy.
import { Capacitor } from '@capacitor/core';
import { BarcodeFormat, BarcodeScanner } from '@capacitor-mlkit/barcode-scanning';

/** Why a scan produced nothing. `cancelled` covers the user backing out, which
 *  is not a failure and must not be reported as one. */
export type ScanFailure =
  | 'unsupported-platform'
  | 'no-camera'
  | 'permission-denied'
  | 'scanner-installing'
  | 'cancelled'
  | 'error';

export type ScanResult = { value: string } | { failure: ScanFailure };

/** What to say about each failure. Kept beside the reasons so the two screens
 *  cannot word the same problem differently. */
export const SCAN_MESSAGES: Record<Exclude<ScanFailure, 'cancelled'>, string> = {
  'unsupported-platform': 'Scanning needs the app. Type the code instead.',
  'no-camera': 'This device has no camera to scan with.',
  'permission-denied': 'Nearside needs the camera to scan a code.',
  'scanner-installing': 'Setting up the scanner. Try again in a moment.',
  error: 'Could not open the camera.',
};

/**
 * Opens the camera and returns the first QR code it reads.
 *
 * The permission is asked for here, at the moment of scanning, and never at
 * launch: a messenger that wants the camera on first run reads as a red flag to
 * exactly the people this app is for.
 */
export async function scanQr(): Promise<ScanResult> {
  if (!Capacitor.isNativePlatform()) return { failure: 'unsupported-platform' };

  try {
    const { supported } = await BarcodeScanner.isSupported();
    if (!supported) return { failure: 'no-camera' };

    const { camera } = await BarcodeScanner.requestPermissions();
    if (camera !== 'granted' && camera !== 'limited') return { failure: 'permission-denied' };

    const { available } = await BarcodeScanner.isGoogleBarcodeScannerModuleAvailable();
    if (!available) {
      // This only starts the download. There is nothing meaningful to await, so
      // say so rather than leaving someone on a spinner.
      await BarcodeScanner.installGoogleBarcodeScannerModule();
      return { failure: 'scanner-installing' };
    }

    const { barcodes } = await BarcodeScanner.scan({ formats: [BarcodeFormat.QrCode] });
    const value = barcodes[0]?.rawValue;
    return value ? { value } : { failure: 'cancelled' };
  } catch {
    return { failure: 'error' };
  }
}
