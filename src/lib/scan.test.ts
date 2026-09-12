import { describe, expect, it } from 'vitest';
import { isScanCancelled } from './scan';

describe('isScanCancelled', () => {
  // The string the plugin rejects with when the user leaves the scanner —
  // BarcodeScannerPlugin.ERROR_SCAN_CANCELED, identical in Java and Swift.
  it('reads the plugin cancellation as a cancellation', () => {
    expect(isScanCancelled(new Error('scan canceled.'))).toBe(true);
    expect(isScanCancelled('scan canceled.')).toBe(true);
  });

  it('leaves a real failure a failure', () => {
    expect(isScanCancelled(new Error('The scan failed.'))).toBe(false);
    expect(isScanCancelled(undefined)).toBe(false);
  });
});
